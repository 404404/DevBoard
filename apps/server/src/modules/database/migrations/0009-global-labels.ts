export const GLOBAL_LABELS_SQL = `
CREATE TABLE global_labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (
    name = trim(name) AND length(name) BETWEEN 1 AND 40
  ),
  sort_order INTEGER NOT NULL UNIQUE CHECK (sort_order >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

WITH task_labels(name) AS (
  SELECT trim(CAST(json_each.value AS TEXT))
  FROM tasks, json_each(tasks.labels_json)
  WHERE json_each.type = 'text'
    AND length(trim(CAST(json_each.value AS TEXT))) BETWEEN 1 AND 40
),
distinct_labels(name) AS (
  SELECT name
  FROM task_labels
  GROUP BY name COLLATE BINARY
),
ordered_labels(name, sort_order) AS (
  SELECT
    name,
    row_number() OVER (ORDER BY name COLLATE NOCASE, name COLLATE BINARY) - 1
  FROM distinct_labels
)
INSERT INTO global_labels (id, name, sort_order)
SELECT
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  name,
  sort_order
FROM ordered_labels;
`;
